import { describe, expect, it } from 'vitest'
import { readSse } from './sse.js'

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    },
  })
}

describe('readSse', () => {
  it('handles events split across chunks, CRLF and multi-line data', async () => {
    const out = []
    for await (const e of readSse(
      stream(['event: a\r\ndata: {"x"', ':1}\r\n\r\ndata: line1\ndata: line2\n\n', 'data: tail']),
    ))
      out.push(e)
    expect(out).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: undefined, data: 'line1\nline2' },
      { event: undefined, data: 'tail' },
    ])
  })
})
