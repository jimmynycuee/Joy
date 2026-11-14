// OpenAI Responses API backend: streaming text, function calling, structured output, resume via
// previous_response_id. Used for the cheap high-frequency roles (assistant brain, background work).
import { readFile } from 'node:fs/promises'
import type {
  AgentEvent,
  AgentProvider,
  ModelRef,
  ProviderCapabilities,
  ProviderHealth,
  RunOptions,
} from '@joy/core'
import type { Rec } from '../guards.js'
import { isRecord, num, opt, rec, str } from '../guards.js'
import { readSse } from './sse.js'

/** A function the model may call. MCP tools are bridged into this shape by the Tool Hub (T2.2). */
export interface ApiTool {
  name: string
  description: string
  /** JSON Schema of the arguments object. */
  parameters: object
  run(args: unknown, signal: AbortSignal): Promise<unknown>
}

/** USD per million tokens. Prices change: they come from configuration, never from code. */
export interface ModelPrice {
  input: number
  cachedInput?: number
  output: number
}

export interface OpenAiApiOptions {
  /** Called per run, so a key changed in settings applies immediately. */
  apiKey: () => Promise<string | null>
  baseUrl?: string
  tools?: ApiTool[]
  pricing?: Record<string, ModelPrice>
  /** Tool-call round trips per run before giving up. Default 10. */
  maxToolRounds?: number
  timeoutMs?: number
  fetch?: typeof fetch
}

interface Usage {
  input: number
  cached: number
  output: number
}

interface TurnResult {
  responseId: string
  text: string
  calls: { callId: string; name: string; args: string }[]
  usage: Usage
  failed?: string
}

export class OpenAiApiProvider implements AgentProvider {
  readonly kind = 'openai-api' as const
  readonly capabilities: ProviderCapabilities = {
    codeEdit: false,
    tools: true,
    resume: true,
    presetSessionId: false,
    delegatedApproval: false,
    quotaEvents: false,
    structuredOutput: true,
  }

  private readonly baseUrl: string
  private readonly tools: ApiTool[]
  private readonly maxToolRounds: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: OpenAiApiOptions) {
    this.baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    this.tools = options.tools ?? []
    this.maxToolRounds = options.maxToolRounds ?? 10
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
    this.fetchImpl = options.fetch ?? fetch
  }

  async *run(opts: RunOptions, model: ModelRef): AsyncGenerator<AgentEvent> {
    const key = await this.options.apiKey()
    if (!key)
      throw new Error('OpenAI API key is not set. Add it in Joy settings (stored in the OS keychain).')
    const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(this.timeoutMs)])

    let previous = opts.resumeSessionId
    let input: unknown[] = [{ role: 'user', content: await userContent(opts) }]
    const total: Usage = { input: 0, cached: 0, output: 0 }
    const state = { started: false }
    let lastText = ''

    for (let round = 0; ; round++) {
      let turn: TurnResult
      try {
        turn = yield* this.turn(key, model, opts, input, previous, signal, state)
      } catch (err) {
        yield* this.fail(err, opts.signal, previous ?? '', total, model)
        return
      }
      if (!state.started) {
        // A stream that never sent response.created still needs its session_started first.
        state.started = true
        yield { type: 'session_started', sessionId: turn.responseId, model: model.model }
      }
      add(total, turn.usage)
      previous = turn.responseId
      if (turn.text) lastText = turn.text
      if (turn.failed) {
        yield { type: 'error', message: turn.failed, recoverable: false }
        yield this.usageEvent(total, model)
        yield { type: 'done', sessionId: previous, isError: true }
        return
      }
      if (turn.calls.length === 0) break
      if (round + 1 >= this.maxToolRounds) {
        yield {
          type: 'error',
          message: `Stopped after ${this.maxToolRounds} tool rounds`,
          recoverable: false,
        }
        yield this.usageEvent(total, model)
        yield { type: 'done', sessionId: previous, isError: true }
        return
      }
      input = []
      for (const call of turn.calls) {
        let parsed: unknown
        try {
          parsed = call.args ? JSON.parse(call.args) : {}
        } catch {
          parsed = call.args
        }
        yield { type: 'tool_call', id: call.callId, name: call.name, input: parsed }
        const tool = this.tools.find((t) => t.name === call.name)
        let output: unknown
        let isError = false
        try {
          if (!tool) throw new Error(`Unknown tool "${call.name}"`)
          output = await tool.run(parsed, signal)
        } catch (err) {
          output = (err as Error).message
          isError = true
        }
        yield { type: 'tool_result', id: call.callId, output, isError }
        input.push({
          type: 'function_call_output',
          call_id: call.callId,
          output: typeof output === 'string' ? output : JSON.stringify(output ?? null),
        })
      }
    }

    let structured: unknown
    if (opts.outputSchema && lastText) {
      try {
        structured = JSON.parse(lastText)
      } catch {
        structured = undefined
      }
    }
    yield this.usageEvent(total, model)
    yield {
      type: 'done',
      sessionId: previous ?? '',
      isError: false,
      ...opt('finalMessage', lastText || undefined),
      ...opt('structured', structured),
    }
  }

  /** One streamed request. Yields text deltas as `message`/`thinking` events; returns what the turn produced. */
  private async *turn(
    key: string,
    model: ModelRef,
    opts: RunOptions,
    input: unknown[],
    previous: string | undefined,
    signal: AbortSignal,
    state: { started: boolean },
  ): AsyncGenerator<AgentEvent, TurnResult> {
    const body: Rec = {
      model: model.model,
      input,
      stream: true,
      ...(previous ? { previous_response_id: previous } : {}),
      ...(model.effort ? { reasoning: { effort: model.effort === 'max' ? 'high' : model.effort } } : {}),
      ...(this.tools.length
        ? {
            tools: this.tools.map((t) => ({
              type: 'function',
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          }
        : {}),
      ...(opts.outputSchema
        ? {
            text: {
              format: { type: 'json_schema', name: 'output', schema: opts.outputSchema, strict: true },
            },
          }
        : {}),
    }
    const res = await this.fetchImpl(`${this.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || !res.body) throw new HttpError(res.status, await safeText(res))

    const result: TurnResult = {
      responseId: '',
      text: '',
      calls: [],
      usage: { input: 0, cached: 0, output: 0 },
    }
    for await (const { data } of readSse(res.body)) {
      if (data === '[DONE]') break
      let ev: unknown
      try {
        ev = JSON.parse(data)
      } catch {
        continue
      }
      if (!isRecord(ev)) continue
      const response = rec(ev.response)
      switch (ev.type) {
        case 'response.created':
          result.responseId = str(response?.id) ?? result.responseId
          if (!state.started) {
            state.started = true
            yield { type: 'session_started', sessionId: result.responseId, model: model.model }
          }
          break
        case 'response.output_text.done': {
          const text = str(ev.text) ?? ''
          result.text += text
          if (text) yield { type: 'message', text }
          break
        }
        case 'response.reasoning_summary_text.done': {
          const text = str(ev.text)
          if (text) yield { type: 'thinking', text }
          break
        }
        case 'response.output_item.done': {
          const item = rec(ev.item)
          if (item?.type === 'function_call') {
            result.calls.push({
              callId: str(item.call_id) ?? str(item.id) ?? '',
              name: str(item.name) ?? '',
              args: str(item.arguments) ?? '',
            })
          }
          break
        }
        case 'response.completed':
        case 'response.incomplete':
        case 'response.failed': {
          result.responseId = str(response?.id) ?? result.responseId
          const usage = rec(response?.usage)
          result.usage = {
            input: num(usage?.input_tokens) ?? 0,
            cached: num(rec(usage?.input_tokens_details)?.cached_tokens) ?? 0,
            output: num(usage?.output_tokens) ?? 0,
          }
          if (ev.type === 'response.failed') {
            result.failed = str(rec(response?.error)?.message) ?? 'OpenAI response failed'
          } else if (ev.type === 'response.incomplete') {
            result.failed = `Response incomplete: ${str(rec(response?.incomplete_details)?.reason) ?? 'unknown reason'}`
          }
          break
        }
        case 'error':
          result.failed = str(ev.message) ?? 'OpenAI stream error'
          break
        default:
          break
      }
    }
    return result
  }

  private *fail(
    err: unknown,
    outer: AbortSignal,
    sessionId: string,
    total: Usage,
    model: ModelRef,
  ): Generator<AgentEvent> {
    if (err instanceof HttpError && err.status === 429) {
      yield { type: 'quota', status: 'limited', windows: [] }
    }
    const message = outer.aborted
      ? 'Cancelled'
      : err instanceof HttpError
        ? err.message
        : (err as Error).name === 'TimeoutError'
          ? `OpenAI API did not finish within ${Math.round(this.timeoutMs / 1000)} s`
          : `OpenAI API request failed: ${(err as Error).message}`
    yield { type: 'error', message, recoverable: false }
    yield this.usageEvent(total, model)
    yield { type: 'done', sessionId, isError: true }
  }

  private usageEvent(total: Usage, model: ModelRef): AgentEvent {
    const price = this.options.pricing?.[model.model]
    const cost = price
      ? ((total.input - total.cached) * price.input +
          total.cached * (price.cachedInput ?? price.input) +
          total.output * price.output) /
        1_000_000
      : undefined
    return {
      type: 'usage',
      inputTokens: total.input,
      outputTokens: total.output,
      cachedInputTokens: total.cached,
      ...opt('costUsd', cost),
    }
  }

  async healthCheck(): Promise<ProviderHealth> {
    const key = await this.options.apiKey().catch(() => null)
    if (!key) return { ok: false, installed: true, loggedIn: false, detail: 'OpenAI API key is not set' }
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (res.ok) return { ok: true, installed: true, loggedIn: true }
      return { ok: false, installed: true, loggedIn: res.status !== 401, detail: `HTTP ${res.status}` }
    } catch (err) {
      return { ok: false, installed: true, loggedIn: 'unknown', detail: (err as Error).message }
    }
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`OpenAI API returned HTTP ${status}${body ? `: ${extractMessage(body)}` : ''}`)
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown
    return str(rec(rec(parsed)?.error)?.message) ?? body.slice(0, 300)
  } catch {
    return body.slice(0, 300)
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function add(total: Usage, u: Usage): void {
  total.input += u.input
  total.cached += u.cached
  total.output += u.output
}

/**
 * The first user message. Images go as `input_image` parts with a data URL (Responses API image input), read from
 * disk here so nothing but this request carries them.
 */
async function userContent(opts: RunOptions): Promise<unknown> {
  if (!opts.images?.length) return opts.prompt
  const images = await Promise.all(
    opts.images.map(async (image) => {
      try {
        const data = (await readFile(image.path)).toString('base64')
        return { type: 'input_image', image_url: `data:${image.mediaType};base64,${data}` }
      } catch (error) {
        throw new Error(
          `An attached image could not be read (${error instanceof Error ? error.message : String(error)}).`,
          { cause: error },
        )
      }
    }),
  )
  return [{ type: 'input_text', text: opts.prompt }, ...images]
}
