import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { resolveCommandCached } from './windows.js'

export interface ProcessSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  /** Kill the process after this long. Codex retries forever without a network, so every run needs one. */
  timeoutMs: number
  /** Keep stdin open for writing (Claude's streaming input). Default: stdin is closed. */
  stdin?: boolean
}

export interface ProcessExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
  /** Last few KB of stderr, for error messages. */
  stderrTail: string
  aborted: boolean
  timedOut: boolean
  /** Set when the process could not be started at all (e.g. ENOENT). */
  spawnError?: Error
}

export type JsonlLine = { ok: true; value: unknown } | { ok: false; line: string }

export interface JsonlProcess {
  lines: AsyncIterable<JsonlLine>
  exit: Promise<ProcessExit>
  /** Present when `stdin` was requested. */
  input?: ProcessInput
}

export interface ProcessInput {
  /** Writes one line; false when stdin is already closed (ended, or the process is gone). */
  writeLine(line: string): boolean
  /** Closes stdin (EOF). Safe to call more than once. */
  end(): void
  readonly closed: boolean
}

const STDERR_TAIL = 4096

/**
 * Spawns a CLI without a shell, stdin closed unless `spec.stdin`, and yields each stdout line parsed as JSON.
 * Aborting or timing out kills the whole process tree.
 */
export function runJsonlProcess(spec: ProcessSpec): JsonlProcess {
  const isWindows = process.platform === 'win32'
  // Windows .cmd shims cannot start without a shell; run the script they point at instead (T4.4).
  const resolved = isWindows ? resolveCommandCached(spec.command) : { command: spec.command, prefix: [] }
  const stdio: ['pipe' | 'ignore', 'pipe', 'pipe'] = [spec.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
  const child = spawn(resolved.command, [...resolved.prefix, ...spec.args], {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio,
    shell: false,
    windowsHide: true,
    // Own process group on POSIX so we can kill the CLI and everything it started.
    detached: !isWindows,
  })
  // stdout and stderr are always piped; only stdin varies, which widens the spawn overload's types.
  const stdout = child.stdout as Readable
  const stderr = child.stderr as Readable

  let stderrTail = ''
  let aborted = false
  let timedOut = false
  let spawnError: Error | undefined

  stderr.setEncoding('utf8')
  stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL)
  })

  const kill = () => killProcessTree(child.pid, isWindows)
  const onAbort = () => {
    aborted = true
    kill()
  }
  if (spec.signal.aborted) onAbort()
  else spec.signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    kill()
  }, spec.timeoutMs)

  const exit = new Promise<ProcessExit>((resolve) => {
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer)
      spec.signal.removeEventListener('abort', onAbort)
      const result: ProcessExit = { exitCode, signal, stderrTail, aborted, timedOut }
      if (spawnError) result.spawnError = spawnError
      resolve(result)
    }
    child.on('error', (err) => {
      spawnError = err
      // 'close' does not always follow a spawn failure.
      if (child.pid === undefined) finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })

  async function* lines(): AsyncGenerator<JsonlLine> {
    const rl = createInterface({ input: stdout, crlfDelay: Infinity })
    for await (const raw of rl) {
      const line = raw.trim()
      if (line === '') continue
      try {
        yield { ok: true, value: JSON.parse(line) as unknown }
      } catch {
        yield { ok: false, line }
      }
    }
  }

  let input: ProcessInput | undefined
  const stdin = child.stdin
  if (spec.stdin && stdin) {
    let closed = false
    // EPIPE when the CLI exits before reading everything: the run's result says what happened.
    stdin.on('error', () => {
      closed = true
    })
    void exit.then(() => {
      closed = true
    })
    input = {
      writeLine(line) {
        if (closed || stdin.destroyed || stdin.writableEnded) return false
        stdin.write(`${line}\n`)
        return true
      },
      end() {
        if (closed) return
        closed = true
        stdin.end()
      },
      get closed() {
        return closed || stdin.destroyed || stdin.writableEnded
      },
    }
  }

  return { lines: lines(), exit, ...(input ? { input } : {}) }
}

export function killProcessTree(pid: number | undefined, isWindows = process.platform === 'win32'): void {
  if (pid === undefined) return
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, 'SIGTERM')
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          // Already gone.
        }
      }, 2000).unref()
    }
  } catch {
    // Already gone.
  }
}
