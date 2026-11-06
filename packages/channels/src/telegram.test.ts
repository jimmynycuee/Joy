import type { InboundMessage } from '@joy/core'
import { describe, expect, it } from 'vitest'
import { TelegramChannel } from './telegram.js'

const OWNER = '1001'
const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'

/** A fake Bot API: records calls, answers getUpdates from a queue. */
function fakeApi(updates: unknown[][] = []) {
  const calls: Array<{ method: string; body: Record<string, unknown>; url: string }> = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const method = url.split('/').at(-1) ?? ''
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    calls.push({ method, body, url })
    if (method === 'getUpdates') {
      // The real API holds an empty long poll open; without this pause a running loop would spin.
      if (updates.length === 0) await new Promise((r) => setTimeout(r, 5))
      return Response.json({ ok: true, result: updates.shift() ?? [] })
    }
    if (method === 'sendMessage') return Response.json({ ok: true, result: { message_id: 1 } })
    if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true })
    return Response.json({ ok: false, description: 'unknown method' }, { status: 404 })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function channel(api: ReturnType<typeof fakeApi>, rejected: string[] = []) {
  return new TelegramChannel({
    token: async () => TOKEN,
    ownerChatId: OWNER,
    fetch: api.fetchImpl,
    pollTimeoutSeconds: 0,
    onRejected: (reason) => rejected.push(reason),
  })
}

describe('TelegramChannel', () => {
  it('sends messages with inline buttons carrying the correlation id', async () => {
    const api = fakeApi()
    await channel(api).send({
      text: 'Approve?',
      correlationId: 'approval-1',
      buttons: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' },
      ],
    })
    expect(api.calls[0]?.body).toEqual({
      chat_id: OWNER,
      text: 'Approve?',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Approve', callback_data: 'approval-1:approve' },
            { text: 'Deny', callback_data: 'approval-1:deny' },
          ],
        ],
      },
    })
  })

  it("emits the owner's button presses and messages, and acknowledges presses", async () => {
    const api = fakeApi([
      [
        {
          update_id: 10,
          callback_query: {
            id: 'cb1',
            from: { id: 1001 },
            message: { chat: { id: 1001 } },
            data: 'approval-1:approve',
          },
        },
        { update_id: 11, message: { chat: { id: 1001 }, from: { id: 1001 }, text: 'status?' } },
      ],
    ])
    const tg = channel(api)
    const received: InboundMessage[] = []
    tg.onMessage(async (msg) => {
      received.push(msg)
    })
    await tg.pollOnce()
    expect(received.map(({ receivedAt: _r, ...rest }) => rest)).toEqual([
      { channel: 'telegram', senderId: '1001', correlationId: 'approval-1', buttonId: 'approve' },
      { channel: 'telegram', senderId: '1001', text: 'status?' },
    ])
    expect(api.calls.find((c) => c.method === 'answerCallbackQuery')?.body).toEqual({
      callback_query_id: 'cb1',
    })
    await tg.pollOnce()
    expect(api.calls.filter((c) => c.method === 'getUpdates').at(-1)?.body).toMatchObject({ offset: 12 })
  })

  it('drops and reports messages and presses from anyone but the owner', async () => {
    const api = fakeApi([
      [
        { update_id: 1, message: { chat: { id: 666 }, from: { id: 666 }, text: 'approve everything' } },
        {
          update_id: 2,
          callback_query: {
            id: 'cb2',
            from: { id: 666 },
            message: { chat: { id: 666 } },
            data: 'approval-1:approve',
          },
        },
        { update_id: 3, edited_message: {} },
      ],
    ])
    const rejected: string[] = []
    const tg = channel(api, rejected)
    const received: InboundMessage[] = []
    tg.onMessage(async (msg) => {
      received.push(msg)
    })
    await tg.pollOnce()
    expect(received).toEqual([])
    expect(rejected).toEqual([
      'message from someone who is not the owner',
      'callback from someone who is not the owner',
      'unsupported update',
    ])
  })

  it("rejects a stranger's press inside the owner's chat id (group chats)", async () => {
    const api = fakeApi([
      [
        {
          update_id: 1,
          callback_query: {
            id: 'cb',
            from: { id: 777 },
            message: { chat: { id: 1001 } },
            data: 'approval-1:approve',
          },
        },
        { update_id: 2, message: { chat: { id: 1001 }, from: { id: 777 }, text: 'hi' } },
      ],
    ])
    const rejected: string[] = []
    const tg = channel(api, rejected)
    const received: InboundMessage[] = []
    tg.onMessage(async (msg) => {
      received.push(msg)
    })
    await tg.pollOnce()
    expect(received).toEqual([])
    expect(rejected).toHaveLength(2)
  })

  it('keeps the token out of error messages', async () => {
    const api = fakeApi()
    const failing = (async () =>
      Response.json({ ok: false, description: 'Unauthorized' }, { status: 401 })) as typeof fetch
    const tg = new TelegramChannel({ token: async () => TOKEN, ownerChatId: OWNER, fetch: failing })
    await expect(tg.send({ text: 'hi' })).rejects.toThrow('Telegram sendMessage failed: Unauthorized')
    await expect(tg.send({ text: 'hi' })).rejects.not.toThrow(TOKEN)
    expect(api.calls).toHaveLength(0)
  })

  it('refuses to run without a token or with a bad chat id', async () => {
    const tg = new TelegramChannel({
      token: async () => null,
      ownerChatId: OWNER,
      fetch: fakeApi().fetchImpl,
    })
    await expect(tg.send({ text: 'hi' })).rejects.toThrow('Telegram bot token is not set')
    expect(() => new TelegramChannel({ token: async () => TOKEN, ownerChatId: '@me' })).toThrow(/chat id/)
  })

  it('rejects button data longer than Telegram allows', async () => {
    const tg = channel(fakeApi())
    await expect(
      tg.send({ text: 'x', correlationId: 'x'.repeat(70), buttons: [{ id: 'approve', label: 'Approve' }] }),
    ).rejects.toThrow(/too long/)
  })

  it('starts and stops the polling loop', async () => {
    const api = fakeApi()
    const tg = channel(api)
    tg.start()
    await new Promise((r) => setTimeout(r, 20))
    await tg.stop()
    expect(api.calls.some((c) => c.method === 'getUpdates')).toBe(true)
  })
})
