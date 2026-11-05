import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface ProcessSpec {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  /** Kill the process after this long. Codex retries forever without a network, so every run needs one. */
  timeoutMs: number
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
}

const STDERR_TAIL = 4096

/**
 * Spawns a CLI without a shell, stdin closed, and yields each stdout line parsed as JSON.
 * Aborting or timing out kills the whole process tree.
 */
export function runJsonlProcess(spec: ProcessSpec): JsonlProcess {
  const isWindows = process.platform === 'win32'
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
    // Own process group on POSIX so we can kill the CLI and everything it started.
    detached: !isWindows,
  })

  let stderrTail = ''
  let aborted = false
  let timedOut = false
  let spawnError: Error | undefined

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL)
  })

  const kill = () => killTree(child.pid, isWindows)
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
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
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

  return { lines: lines(), exit }
}

function killTree(pid: number | undefined, isWindows: boolean): void {
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
