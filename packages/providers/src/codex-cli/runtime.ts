import { runJsonlProcess } from '../process.js'

export interface CodexRuntimeProbe {
  installed: boolean
  ok: boolean
  version?: string
  detail?: string
}

interface CommandResult {
  started: boolean
  exitCode: number | null
  output: string
  stderr: string
  spawnError?: Error
}

async function capture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
): Promise<CommandResult> {
  const proc = runJsonlProcess({
    command,
    args,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    timeoutMs: 15_000,
    ...(env ? { env } : {}),
  })
  const output: string[] = []
  for await (const line of proc.lines) {
    output.push(
      line.ok ? (typeof line.value === 'string' ? line.value : JSON.stringify(line.value)) : line.line,
    )
  }
  const exit = await proc.exit
  return {
    started: !exit.spawnError,
    exitCode: exit.exitCode,
    output: output.join('\n').trim(),
    stderr: exit.stderrTail.trim(),
    ...(exit.spawnError ? { spawnError: exit.spawnError } : {}),
  }
}

/** Probe the Codex CLI without starting a task or relying on its login state. */
export async function probeCodexRuntime(
  command: string,
  argsPrefix: string[],
  env: NodeJS.ProcessEnv | undefined,
  options: { throughWsl?: boolean } = {},
): Promise<CodexRuntimeProbe> {
  const version = await capture(command, [...argsPrefix, '--version'], env)
  const installed = options.throughWsl ? version.exitCode === 0 : version.started
  if (!version.started || version.exitCode !== 0) {
    return {
      installed,
      ok: false,
      detail: version.spawnError?.message || version.stderr || version.output || 'Codex --version failed',
    }
  }

  const exec = await capture(command, [...argsPrefix, 'exec', '--help'], env)
  if (!exec.started || exec.exitCode !== 0) {
    return {
      installed,
      ok: false,
      ...(version.output ? { version: version.output } : {}),
      detail: exec.spawnError?.message || exec.stderr || exec.output || 'Codex exec --help failed',
    }
  }

  return { installed: true, ok: true, ...(version.output ? { version: version.output } : {}) }
}

/** Test whether WSL can launch the Codex executable in its default distribution. */
export function probeWslCodex(
  wslCommand: string,
  wslArgsPrefix: string[],
  codexCommand: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<CodexRuntimeProbe> {
  return probeCodexRuntime(wslCommand, [...wslArgsPrefix, '--exec', codexCommand], env, { throughWsl: true })
}

/** Convert a host path for use by a Linux process launched through WSL. */
export async function toWslPath(
  wslCommand: string,
  wslArgsPrefix: string[],
  hostPath: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  const result = await capture(wslCommand, [...wslArgsPrefix, '--exec', 'wslpath', '-u', hostPath], env)
  if (!result.started || result.exitCode !== 0 || !result.output) {
    throw new Error(
      `Could not convert a Windows path for WSL: ${result.stderr || result.output || result.spawnError?.message || 'wslpath failed'}`,
    )
  }
  return result.output.split(/\r?\n/).at(-1) ?? result.output
}
