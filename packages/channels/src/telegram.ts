// Telegram Bot API channel: long-polls for updates, accepts only the owner's chat, sends messages with inline
// buttons. Uses fetch directly so tests can point it at a local fake API.
import type { Channel, InboundMessage, OutboundMessage } from '@joy/core'

export interface TelegramChannelOptions {
  /** Read on every request, so a token changed in settings applies without a restart. */
  token: () => Promise<string | null>
  /** The only chat whose messages and button presses are accepted. */
  ownerChatId: string
  baseUrl?: string
  fetch?: typeof fetch
  /** Long-poll duration per getUpdates call. */
  pollTimeoutSeconds?: number
  /** Called for anything dropped (strangers, malformed updates) so it can be logged. */
  onRejected?: (reason: string, detail: unknown) => void
  /** Called when the API cannot be reached; polling backs off and retries. */
  onError?: (error: Error) => void
}

type Handler = (msg: InboundMessage) => Promise<void>

/** Telegram limits callback_data to 64 bytes. */
const MAX_CALLBACK_DATA = 64

export class TelegramChannel implements Channel {
  readonly id = 'telegram' as const
  private readonly handlers = new Set<Handler>()
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private offset = 0
  private controller: AbortController | undefined
  private loop: Promise<void> | undefined

  constructor(private readonly options: TelegramChannelOptions) {
    if (!/^-?\d+$/.test(options.ownerChatId)) throw new Error('Telegram owner chat id must be a number')
    this.baseUrl = (options.baseUrl ?? 'https://api.telegram.org').replace(/\/$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  onMessage(handler: Handler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  async send(msg: OutboundMessage): Promise<void> {
    const keyboard = msg.buttons?.length
      ? {
          inline_keyboard: [
            msg.buttons.map((button) => {
              const data = `${msg.correlationId ?? ''}:${button.id}`
              if (Buffer.byteLength(data) > MAX_CALLBACK_DATA)
                throw new Error('Telegram button data is too long')
              return { text: button.label, callback_data: data }
            }),
          ],
        }
      : undefined
    await this.call('sendMessage', {
      chat_id: this.options.ownerChatId,
      text: msg.text.slice(0, 4096),
      ...(keyboard ? { reply_markup: keyboard } : {}),
    })
  }

  /** Starts long polling. Safe to call once; `stop()` ends it. */
  start(): void {
    if (this.loop) return
    this.controller = new AbortController()
    this.loop = this.poll(this.controller.signal)
  }

  async stop(): Promise<void> {
    this.controller?.abort()
    await this.loop?.catch(() => undefined)
    this.loop = undefined
  }

  /** One getUpdates round; exposed for tests and for callers that drive polling themselves. */
  async pollOnce(signal?: AbortSignal): Promise<number> {
    const updates = (await this.call(
      'getUpdates',
      {
        offset: this.offset,
        timeout: this.options.pollTimeoutSeconds ?? 25,
        allowed_updates: ['message', 'callback_query'],
      },
      signal,
    )) as unknown
    if (!Array.isArray(updates)) return 0
    for (const update of updates) {
      const id = (update as { update_id?: unknown }).update_id
      if (typeof id === 'number') this.offset = Math.max(this.offset, id + 1)
      await this.handleUpdate(update)
    }
    return updates.length
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let delay = 1000
    while (!signal.aborted) {
      try {
        const received = await this.pollOnce(signal)
        delay = 1000
        // A real long poll holds an empty request open; if an API answers empty at once, do not spin.
        if (received === 0) await sleep(200, signal)
      } catch (error) {
        if (signal.aborted) return
        this.options.onError?.(error as Error)
        await sleep(delay, signal)
        delay = Math.min(delay * 2, 60_000)
      }
    }
  }

  private async handleUpdate(update: unknown): Promise<void> {
    const u = update as Record<string, unknown>
    const callback = u.callback_query as Record<string, unknown> | undefined
    if (callback) {
      const chatId = String((callback.message as { chat?: { id?: unknown } } | undefined)?.chat?.id ?? '')
      const fromId = String((callback.from as { id?: unknown } | undefined)?.id ?? '')
      // Answer every press so the button stops spinning, even when it is rejected.
      if (typeof callback.id === 'string') {
        await this.call('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => undefined)
      }
      if (chatId !== this.options.ownerChatId) {
        this.options.onRejected?.('callback from a chat that is not the owner', { chatId, fromId })
        return
      }
      const data = typeof callback.data === 'string' ? callback.data : ''
      const sep = data.lastIndexOf(':')
      if (sep <= 0) {
        this.options.onRejected?.('malformed button data', { data })
        return
      }
      await this.emit({
        channel: 'telegram',
        senderId: fromId,
        correlationId: data.slice(0, sep),
        buttonId: data.slice(sep + 1),
        receivedAt: new Date().toISOString(),
      })
      return
    }
    const message = u.message as Record<string, unknown> | undefined
    if (message) {
      const chatId = String((message.chat as { id?: unknown } | undefined)?.id ?? '')
      if (chatId !== this.options.ownerChatId) {
        this.options.onRejected?.('message from a chat that is not the owner', { chatId })
        return
      }
      const text = typeof message.text === 'string' ? message.text : undefined
      await this.emit({
        channel: 'telegram',
        senderId: String((message.from as { id?: unknown } | undefined)?.id ?? chatId),
        ...(text !== undefined ? { text } : {}),
        receivedAt: new Date().toISOString(),
      })
      return
    }
    this.options.onRejected?.('unsupported update', update)
  }

  private async emit(msg: InboundMessage): Promise<void> {
    for (const handler of this.handlers) {
      try {
        await handler(msg)
      } catch (error) {
        this.options.onError?.(error as Error)
      }
    }
  }

  private async call(method: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const token = await this.options.token()
    if (!token) throw new Error('Telegram bot token is not set')
    const response = await this.fetchImpl(`${this.baseUrl}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const parsed = (await response.json().catch(() => ({}))) as {
      ok?: boolean
      result?: unknown
      description?: string
    }
    // Never include the URL in errors: it contains the token.
    if (!response.ok || !parsed.ok)
      throw new Error(`Telegram ${method} failed: ${parsed.description ?? response.status}`)
    return parsed.result
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}
