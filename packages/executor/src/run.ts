import { spawn } from 'node:child_process'

export interface RunCommandInput {
  /** Program to start; never passed through a shell. */
  command: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  /** Stopped after this long. Default 10 minutes. */
  timeoutMs?: number
  /** After SIGTERM, how long the process tree gets before SIGKILL. Default 2 s. */
  killGraceMs?: number
  /** Only the end of the combined stdout/stderr is kept. Default 64 KiB. */
  maxOutputChars?: number
  env?: NodeJS.ProcessEnv
  /** Called once when the run is stopped (timeout or abort), e.g. to `docker kill` a container. */
  onStop?: () => void
  platform?: NodeJS.Platform
}

export interface RunCommandResult {
  /** null when the process could not start or was killed. */
  exitCode: number | null
  /** The last `maxOutputChars` of stdout and stderr, interleaved as they arrived. */
  output: string
  timedOut: boolean
  /** Set when the program could not be started (for example ENOENT). */
  spawnError?: string
}

/**
 * Runs a project command in a worktree without a shell and returns the tail of its output. Never throws.
 * A timeout or abort stops the whole process tree (its own process group on POSIX, `taskkill /T` on Windows), not just
 * the direct child, and the result does not wait for pipes a surviving grandchild might still hold.
 */
export function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const max = input.maxOutputChars ?? 64 * 1024
  const windows = (input.platform ?? process.platform) === 'win32'
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    let stopping = false
    let exited = false
    let exitCode: number | null = null
    const append = (chunk: string) => {
      output = (output + chunk).slice(-max)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        // Its own process group, so a stop reaches every process it started.
        detached: !windows,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(input.env ? { env: input.env } : {}),
      })
    } catch (error) {
      resolve({ exitCode: null, output: '', timedOut: false, spawnError: String(error) })
      return
    }
    const killTree = (signal: NodeJS.Signals) => {
      const pid = child.pid
      if (pid === undefined) return
      if (windows) {
        // Windows reuses pids quickly, and once the child has exited `/T` can no longer find its orphans, so a
        // taskkill now could only hit an unrelated process that took the same pid.
        if (exited) return
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.on('error', () => undefined)
        return
      }
      try {
        process.kill(-pid, signal)
      } catch {
        // The group is already gone.
      }
    }
    let graceTimer: NodeJS.Timeout | undefined
    const finish = (result: RunCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      input.signal?.removeEventListener('abort', stop)
      if (stopping) {
        child.stdout?.destroy()
        child.stderr?.destroy()
      }
      resolve(result)
    }
    const stop = () => {
      if (stopping || settled) return
      stopping = true
      try {
        input.onStop?.()
      } catch {
        // A cleanup hook must not keep the command running.
      }
      killTree('SIGTERM')
      graceTimer = setTimeout(() => {
        killTree('SIGKILL')
        // The tree is gone or unkillable: report now instead of waiting for pipes.
        finish({ exitCode: exited ? exitCode : null, output, timedOut })
      }, input.killGraceMs ?? 2_000)
      // The direct child may already be gone while a grandchild holds the pipes.
      if (exited) {
        killTree('SIGKILL')
        finish({ exitCode, output, timedOut })
      }
    }
    const timer = setTimeout(
      () => {
        timedOut = true
        stop()
      },
      input.timeoutMs ?? 10 * 60_000,
    )
    input.signal?.addEventListener('abort', stop, { once: true })
    if (input.signal?.aborted) stop()
    child.stdout?.setEncoding('utf8').on('data', append)
    child.stderr?.setEncoding('utf8').on('data', append)
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish({ exitCode: null, output, timedOut, spawnError: error.code ?? error.message }),
    )
    child.once('exit', (code) => {
      exited = true
      exitCode = code
      if (stopping) {
        // Leftover processes of the group go too; no waiting for their pipes.
        killTree('SIGKILL')
        finish({ exitCode: code, output, timedOut })
      }
    })
    child.once('close', (code) => finish({ exitCode: code ?? exitCode, output, timedOut }))
  })
}
