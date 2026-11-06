import type { RunOptions } from '@joy/core'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { killProcessTree, type ProcessExit } from '../process.js'
import { spawnErrorMessage } from '../cli-run.js'
import { isRecord, str } from '../guards.js'
import type {
  AppServerWireMessage,
  CommandExecutionApprovalParams,
  FileChangeApprovalParams,
  JsonRpcId,
  ServerApprovalRequest,
} from './app-server-protocol.js'

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel'
export type CodexApprovalRequest =
  | { method: 'item/commandExecution/requestApproval'; params: CommandExecutionApprovalParams }
  | { method: 'item/fileChange/requestApproval'; params: FileChangeApprovalParams }
export type CodexApprovalHandler = (
  request: CodexApprovalRequest,
  runOptions: RunOptions,
) => CodexApprovalDecision | Promise<CodexApprovalDecision>

export type AppServerIncoming =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'raw'; payload: unknown }
  | { kind: 'error'; message: string }

interface AppServerClientOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  signal: AbortSignal
  timeoutMs: number
  approvalHandler?: (request: CodexApprovalRequest) => CodexApprovalDecision | Promise<CodexApprovalDecision>
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** A minimal JSON-RPC-over-JSONL process client for `codex app-server`. */
export class CodexAppServerClient {
  readonly incoming = new AsyncQueue<AppServerIncoming>()
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly exit: Promise<ProcessExit>
  private nextId = 1
  private spawnError: Error | undefined
  private aborted = false
  private timedOut = false
  private didClose = false
  private readonly timer: NodeJS.Timeout
  private readonly onAbort: () => void

  constructor(private readonly options: AppServerClientOptions) {
    const isWindows = process.platform === 'win32'
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: !isWindows,
    })
    this.child.stderr.resume()
    const stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => this.receive(line))

    this.exit = new Promise((resolve) => {
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (this.didClose) return
        this.didClose = true
        clearTimeout(this.timer)
        options.signal.removeEventListener('abort', this.onAbort)
        const result: ProcessExit = {
          exitCode,
          signal,
          stderrTail: '',
          aborted: this.aborted,
          timedOut: this.timedOut,
          ...(this.spawnError ? { spawnError: this.spawnError } : {}),
        }
        resolve(result)
        const error = new Error(this.exitMessage(result))
        for (const request of this.pending.values()) request.reject(error)
        this.pending.clear()
        this.incoming.close(error)
      }
      this.child.on('error', (error) => {
        this.spawnError = error
        if (this.child.pid === undefined) finish(null, null)
      })
      this.child.on('close', (code, signal) => finish(code, signal))
    })

    this.onAbort = () => {
      this.aborted = true
      killProcessTree(this.child.pid, isWindows)
    }
    if (options.signal.aborted) this.onAbort()
    else options.signal.addEventListener('abort', this.onAbort, { once: true })
    this.timer = setTimeout(() => {
      this.timedOut = true
      killProcessTree(this.child.pid, isWindows)
    }, options.timeoutMs)
    this.timer.unref()
    this.child.stdin.on('error', () => {
      // The process exit handler reports the actionable failure to pending requests.
    })
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }))
    try {
      this.write({ id, method, ...(params === undefined ? {} : { params }) })
    } catch (error) {
      this.pending.delete(id)
      throw error
    }
    return response
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  async close(): Promise<void> {
    if (!this.didClose) killProcessTree(this.child.pid, process.platform === 'win32')
    await this.exit
  }

  private write(message: AppServerWireMessage): void {
    if (this.didClose || this.child.stdin.destroyed) throw new Error('Codex app-server is not running')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private receive(line: string): void {
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      this.incoming.push({ kind: 'raw', payload: line })
      return
    }
    const message = isRecord(value) ? value : undefined
    if (!message) {
      this.incoming.push({ kind: 'raw', payload: value })
      return
    }
    if (isRequest(message)) {
      void this.handleServerRequest(message)
      return
    }
    if (isResponse(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (isRecord(message.error)) {
        pending.reject(
          new Error(
            str(message.error.message) ?? `Codex app-server request failed (${String(message.error.code)})`,
          ),
        )
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (typeof message.method === 'string') {
      this.incoming.push({ kind: 'notification', method: message.method, params: message.params })
      return
    }
    this.incoming.push({ kind: 'raw', payload: value })
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    const request = parseApprovalRequest(message)
    if (!request) {
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported Codex app-server request' } })
      return
    }
    let decision: CodexApprovalDecision = 'decline'
    if (this.options.approvalHandler) {
      try {
        decision = await this.options.approvalHandler(request)
      } catch {
        this.incoming.push({
          kind: 'error',
          message: 'Codex approval policy failed; the requested action was denied',
        })
      }
    }
    if (
      request.method === 'item/commandExecution/requestApproval' &&
      request.params.kind === 'humanCommand'
    ) {
      if (decision === 'acceptForSession') decision = 'accept'
    }
    try {
      this.write({ id: message.id, result: { decision } })
    } catch {
      // The app-server may have exited while the policy handler was deciding.
    }
  }

  private exitMessage(exit: ProcessExit): string {
    if (exit.spawnError) {
      const error = exit.spawnError as NodeJS.ErrnoException
      return spawnErrorMessage('Codex', this.options.command, this.options.cwd, error)
    }
    if (exit.aborted) return 'Cancelled'
    if (exit.timedOut)
      return `Codex app-server did not finish within ${Math.max(1, Math.round(this.options.timeoutMs / 1000))} s and was stopped`
    return `Codex app-server exited (code ${exit.exitCode ?? exit.signal}) without completing the turn`
  }
}

interface JsonRpcRequest {
  id: JsonRpcId
  method: string
  params?: unknown
}

function isRequest(value: Record<string, unknown>): value is Record<string, unknown> & JsonRpcRequest {
  return (typeof value.id === 'string' || typeof value.id === 'number') && typeof value.method === 'string'
}

function isResponse(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { id: JsonRpcId; result?: unknown; error?: unknown } {
  return (
    (typeof value.id === 'string' || typeof value.id === 'number') && ('result' in value || 'error' in value)
  )
}

function parseApprovalRequest(message: JsonRpcRequest): ServerApprovalRequest | undefined {
  const params = isRecord(message.params) ? message.params : undefined
  if (!params) return undefined
  if (
    message.method === 'item/commandExecution/requestApproval' &&
    (params.kind === 'command' || params.kind === 'humanCommand' || params.kind === 'writeStdin') &&
    typeof params.threadId === 'string' &&
    typeof params.turnId === 'string' &&
    typeof params.itemId === 'string' &&
    typeof params.startedAtMs === 'number' &&
    (typeof params.environmentId === 'string' || params.environmentId === null)
  ) {
    return { method: message.method, id: message.id, params: params as CommandExecutionApprovalParams }
  }
  if (
    message.method === 'item/fileChange/requestApproval' &&
    typeof params.threadId === 'string' &&
    typeof params.turnId === 'string' &&
    typeof params.itemId === 'string' &&
    typeof params.startedAtMs === 'number'
  ) {
    return { method: message.method, id: message.id, params: params as FileChangeApprovalParams }
  }
  return undefined
}

class AsyncQueue<T> implements AsyncIterableIterator<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{
    resolve(value: IteratorResult<T>): void
    reject(error: Error): void
  }> = []
  private ended = false
  private failure: Error | undefined

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else if (!this.ended) this.values.push(value)
  }

  close(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift()
    if (value !== undefined) return Promise.resolve({ value, done: false })
    if (this.ended)
      return this.failure ? Promise.reject(this.failure) : Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this
  }
}
