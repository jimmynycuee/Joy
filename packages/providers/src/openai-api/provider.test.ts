import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AgentEvent, RunOptions } from '@joy/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiTool } from './provider.js'
import { OpenAiApiProvider } from './provider.js'

type Handler = (body: Record<string, unknown>, res: ServerResponse) => void
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))))
})

/** A fake OpenAI endpoint. Each POST /responses is answered by the next handler. */
async function fakeOpenAi(handlers: Handler[]) {
  const requests: { headers: IncomingMessage['headers']; body: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => (raw += c.toString()))
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(req.headers.authorization === 'Bearer good' ? 200 : 401).end('{}')
        return
      }
      const body = JSON.parse(raw) as Record<string, unknown>
      requests.push({ headers: req.headers, body })
      const h = handlers[requests.length - 1]
      if (!h) res.writeHead(500).end('no handler')
      else h(body, res)
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests }
}

function sse(res: ServerResponse, events: object[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const e of events) res.write(`event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`)
  res.end()
}

const completed = (
  id: string,
  usage = { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 40 } },
) => ({
  type: 'response.completed',
  response: { id, usage },
})

const model = { provider: 'openai-api', model: 'gpt-6-luna', effort: 'low' } as const
const opts = (over: Partial<RunOptions> = {}): RunOptions => ({
  cwd: '/',
  prompt: 'hello',
  autonomy: 'read-only',
  signal: new AbortController().signal,
  ...over,
})
async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

describe('OpenAiApiProvider', () => {
  it('streams a reply, reports usage with cost, and sends key, model and effort', async () => {
    const api = await fakeOpenAi([
      (_b, res) =>
        sse(res, [
          { type: 'response.created', response: { id: 'resp_1' } },
          { type: 'response.output_text.delta', delta: 'Hi' },
          { type: 'response.output_text.done', text: 'Hi there' },
          completed('resp_1'),
        ]),
    ])
    const provider = new OpenAiApiProvider({
      apiKey: async () => 'sk-test',
      baseUrl: api.baseUrl,
      pricing: { 'gpt-6-luna': { input: 1, cachedInput: 0.1, output: 4 } },
    })
    const events = await collect(provider.run(opts(), model))
    expect(events).toEqual([
      { type: 'session_started', sessionId: 'resp_1', model: 'gpt-6-luna' },
      { type: 'message', text: 'Hi there' },
      {
        type: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 40,
        costUsd: (60 * 1 + 40 * 0.1 + 20 * 4) / 1e6,
      },
      { type: 'done', sessionId: 'resp_1', isError: false, finalMessage: 'Hi there' },
    ])
    expect(api.requests[0]?.headers.authorization).toBe('Bearer sk-test')
    expect(api.requests[0]?.body).toMatchObject({
      model: 'gpt-6-luna',
      stream: true,
      reasoning: { effort: 'low' },
    })
  })

  it('runs tools and continues the same response chain', async () => {
    const api = await fakeOpenAi([
      (_b, res) =>
        sse(res, [
          { type: 'response.created', response: { id: 'r1' } },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'c1', name: 'add', arguments: '{"a":2,"b":2}' },
          },
          completed('r1'),
        ]),
      (_b, res) =>
        sse(res, [
          { type: 'response.created', response: { id: 'r2' } },
          { type: 'response.output_text.done', text: '4' },
          completed('r2'),
        ]),
    ])
    const add: ApiTool = {
      name: 'add',
      description: 'adds',
      parameters: { type: 'object' },
      run: async (args) => (args as { a: number; b: number }).a + (args as { a: number; b: number }).b,
    }
    const provider = new OpenAiApiProvider({ apiKey: async () => 'k', baseUrl: api.baseUrl, tools: [add] })
    const events = await collect(provider.run(opts(), model))
    expect(events.filter((e) => e.type === 'session_started')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result')).toEqual([
      { type: 'tool_call', id: 'c1', name: 'add', input: { a: 2, b: 2 } },
      { type: 'tool_result', id: 'c1', output: 4, isError: false },
    ])
    expect(api.requests[0]?.body.tools).toEqual([
      { type: 'function', name: 'add', description: 'adds', parameters: { type: 'object' } },
    ])
    expect(api.requests[1]?.body).toMatchObject({
      previous_response_id: 'r1',
      input: [{ type: 'function_call_output', call_id: 'c1', output: '4' }],
    })
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'r2', isError: false, finalMessage: '4' })
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 200, outputTokens: 40 })
  })

  it('reports a failing tool back to the model instead of crashing', async () => {
    const api = await fakeOpenAi([
      (_b, res) =>
        sse(res, [
          { type: 'response.created', response: { id: 'r1' } },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'c1', name: 'nope', arguments: '{}' },
          },
          completed('r1'),
        ]),
      (_b, res) => sse(res, [{ type: 'response.created', response: { id: 'r2' } }, completed('r2')]),
    ])
    const provider = new OpenAiApiProvider({ apiKey: async () => 'k', baseUrl: api.baseUrl })
    const events = await collect(provider.run(opts(), model))
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'c1',
      output: 'Unknown tool "nope"',
      isError: true,
    })
    expect(api.requests[1]?.body.input).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'Unknown tool "nope"' },
    ])
  })

  it('resumes from a previous response and parses structured output', async () => {
    const api = await fakeOpenAi([
      (_b, res) =>
        sse(res, [
          { type: 'response.created', response: { id: 'r9' } },
          { type: 'response.output_text.done', text: '{"approve":true}' },
          completed('r9'),
        ]),
    ])
    const provider = new OpenAiApiProvider({ apiKey: async () => 'k', baseUrl: api.baseUrl })
    const schema = { type: 'object', properties: { approve: { type: 'boolean' } } }
    const events = await collect(provider.run(opts({ resumeSessionId: 'r8', outputSchema: schema }), model))
    expect(api.requests[0]?.body).toMatchObject({
      previous_response_id: 'r8',
      text: { format: { type: 'json_schema', schema } },
    })
    expect(events.at(-1)).toMatchObject({ structured: { approve: true } })
  })

  it('maps HTTP 429 to a limited quota and a failing done', async () => {
    const api = await fakeOpenAi([
      (_b, res) => res.writeHead(429).end('{"error":{"message":"Rate limit reached"}}'),
    ])
    const provider = new OpenAiApiProvider({ apiKey: async () => 'k', baseUrl: api.baseUrl })
    const events = await collect(provider.run(opts(), model))
    expect(events.map((e) => e.type)).toEqual(['quota', 'error', 'usage', 'done'])
    expect(events[1]).toMatchObject({ message: 'OpenAI API returned HTTP 429: Rate limit reached' })
    expect(events.at(-1)).toMatchObject({ isError: true })
  })

  it('reports response.failed', async () => {
    const api = await fakeOpenAi([
      (_b, res) =>
        sse(res, [
          { type: 'response.created', response: { id: 'r1' } },
          { type: 'response.failed', response: { id: 'r1', error: { message: 'model overloaded' } } },
        ]),
    ])
    const provider = new OpenAiApiProvider({ apiKey: async () => 'k', baseUrl: api.baseUrl })
    const events = await collect(provider.run(opts(), model))
    expect(events).toContainEqual({ type: 'error', message: 'model overloaded', recoverable: false })
    expect(events.at(-1)).toEqual({ type: 'done', sessionId: 'r1', isError: true })
  })

  it('cancels an in-flight request', async () => {
    const api = await fakeOpenAi([(_b, res) => res.writeHead(200, { 'content-type': 'text/event-stream' })])
    const provider = new OpenAiApiProvider({ apiKey: async () => 'k', baseUrl: api.baseUrl })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const events = await collect(provider.run(opts({ signal: controller.signal }), model))
    expect(events.at(-2)).toBeDefined()
    expect(events).toContainEqual({ type: 'error', message: 'Cancelled', recoverable: false })
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true })
  })

  it('refuses to run without a key', async () => {
    const provider = new OpenAiApiProvider({ apiKey: async () => null })
    await expect(collect(provider.run(opts(), model))).rejects.toThrow(/API key is not set/)
  })

  it('health check distinguishes a missing, bad and good key', async () => {
    const api = await fakeOpenAi([])
    expect(
      await new OpenAiApiProvider({ apiKey: async () => null, baseUrl: api.baseUrl }).healthCheck(),
    ).toMatchObject({
      ok: false,
      loggedIn: false,
    })
    expect(
      await new OpenAiApiProvider({ apiKey: async () => 'bad', baseUrl: api.baseUrl }).healthCheck(),
    ).toMatchObject({
      ok: false,
      loggedIn: false,
    })
    expect(
      await new OpenAiApiProvider({ apiKey: async () => 'good', baseUrl: api.baseUrl }).healthCheck(),
    ).toMatchObject({
      ok: true,
    })
  })
})
