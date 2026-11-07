import { spawn } from 'node:child_process'

export interface RunCommandInput {
  /** Program to start; never passed through a shell. */
  command: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  /** Killed after this long. Default 10 minutes. */
  timeoutMs?: number
  /** Only the end of the combined stdout/stderr is kept. Default 64 KiB. */
  maxOutputChars?: number
  env?: NodeJS.ProcessEnv
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

/** Runs a project command in a worktree without a shell and returns the tail of its output. Never throws. */
export function runCommand(input: RunCommandInput): Promise<RunCommandResult> {
  const max = input.maxOutputChars ?? 64 * 1024
  return new Promise((resolve) => {
    let output = ''
    let timedOut = false
    let settled = false
    const append = (chunk: string) => {
      output = (output + chunk).slice(-max)
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(input.command, input.args, {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(input.env ? { env: input.env } : {}),
      })
    } catch (error) {
      resolve({ exitCode: null, output: '', timedOut: false, spawnError: String(error) })
      return
    }
    const kill = () => {
      if (child.exitCode === null) child.kill()
    }
    const timer = setTimeout(
      () => {
        timedOut = true
        kill()
      },
      input.timeoutMs ?? 10 * 60_000,
    )
    input.signal?.addEventListener('abort', kill, { once: true })
    if (input.signal?.aborted) kill()
    const finish = (result: RunCommandResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', kill)
      resolve(result)
    }
    child.stdout?.setEncoding('utf8').on('data', append)
    child.stderr?.setEncoding('utf8').on('data', append)
    child.once('error', (error: NodeJS.ErrnoException) =>
      finish({ exitCode: null, output, timedOut, spawnError: error.code ?? error.message }),
    )
    child.once('close', (code) => finish({ exitCode: code, output, timedOut }))
  })
}
