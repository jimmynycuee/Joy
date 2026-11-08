import { existsSync } from 'node:fs'
import type { AgentEvent, ProviderKind } from '@joy/core'
import type { ProcessExit, ProcessInput } from './process.js'
import { runJsonlProcess } from './process.js'

/**
 * Lets the server run a CLI some other way, e.g. inside a container for an untrusted repository (T4.5). Receives the
 * normal command line and returns the one to spawn; the working directory stays the same.
 */
export type CommandWrapper = (run: {
  cli: 'claude' | 'codex'
  command: string
  args: string[]
  cwd: string
}) => Promise<{ command: string; args: string[] }>

/** What both CLI parsers provide. */
export interface StreamParser {
  readonly finished: boolean
  push(line: unknown): AgentEvent[]
  /** `exit.stopped`: the process was cancelled or timed out rather than ending on its own. */
  finish(reason: string, exit?: { stopped: boolean }): AgentEvent[]
}

export interface CliRunSpec {
  source: ProviderKind
  /** Human name for error messages, e.g. "Claude Code". */
  label: string
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  timeoutMs: number
  parser: StreamParser
  /** Keeps stdin open and hands it over once the process started (streaming input). */
  onInput?: (input: ProcessInput) => void
}

/**
 * Runs a JSONL-speaking CLI and yields normalized events. Guarantees exactly one `done` unless the
 * process could not be started at all, in which case it throws.
 */
export async function* runCli(spec: CliRunSpec): AsyncGenerator<AgentEvent> {
  const proc = runJsonlProcess({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    signal: spec.signal,
    timeoutMs: spec.timeoutMs,
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.onInput ? { stdin: true } : {}),
  })
  if (spec.onInput && proc.input) spec.onInput(proc.input)
  for await (const line of proc.lines) {
    if (!line.ok) {
      yield { type: 'raw', source: spec.source, payload: line.line }
      continue
    }
    yield* spec.parser.push(line.value)
  }
  const exit = await proc.exit
  if (exit.spawnError) throw spawnFailure(spec, exit)
  if (!spec.parser.finished)
    yield* spec.parser.finish(exitReason(spec, exit), { stopped: exit.aborted || exit.timedOut })
}

function spawnFailure(spec: CliRunSpec, exit: ProcessExit): Error {
  const err = exit.spawnError as NodeJS.ErrnoException
  return new Error(spawnErrorMessage(spec.label, spec.command, spec.cwd, err), { cause: err })
}

/**
 * Node reports ENOENT both for a missing program and for a missing working directory; tell them apart so the
 * user is not sent to reinstall a CLI that is fine.
 */
export function spawnErrorMessage(
  label: string,
  command: string,
  cwd: string,
  err: NodeJS.ErrnoException,
): string {
  if (err.code !== 'ENOENT') return `Could not start ${label}: ${err.message}`
  if (!existsSync(cwd)) return `Could not start ${label}: the working directory does not exist (${cwd})`
  return `${label} CLI not found ("${command}"). Install it and log in, or set its path in Joy's settings.`
}

function exitReason(spec: CliRunSpec, exit: ProcessExit): string {
  if (exit.aborted) return 'Cancelled'
  if (exit.timedOut)
    return `${spec.label} did not finish within ${Math.round(spec.timeoutMs / 1000)} s and was stopped`
  return `${spec.label} exited (code ${exit.exitCode ?? exit.signal}) without a result. ${exit.stderrTail.trim()}`.trim()
}

/** `--version` probe shared by CLI health checks. */
export async function probeVersion(
  command: string,
  argsPrefix: string[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<{ installed: boolean; ok: boolean; version?: string; detail?: string }> {
  const proc = runJsonlProcess({
    command,
    args: [...argsPrefix, '--version'],
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs: 15_000,
    ...(env ? { env } : {}),
  })
  const out: string[] = []
  for await (const line of proc.lines) out.push(line.ok ? String(line.value) : line.line)
  const exit = await proc.exit
  if (exit.spawnError) return { installed: false, ok: false, detail: exit.spawnError.message }
  return exit.exitCode === 0
    ? { installed: true, ok: true, version: out.join(' ').trim() }
    : { installed: true, ok: false, detail: exit.stderrTail.trim() }
}
